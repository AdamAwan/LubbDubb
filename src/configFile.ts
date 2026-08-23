import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Writing `lubbdubb.config.json` without wrecking it.
 *
 * Nothing in the harness wrote this file until the config form existed, and the
 * obvious way to write it is the one thing that must not happen: `JSON.parse` →
 * mutate → `JSON.stringify` reformats every line the operator wrote. The file's
 * documentation convention is `"// key"` entries — ordinary JSON members, so they
 * survive a round trip — but the blank lines that group them, the indent style
 * and the inline `{ "a": 1 }` blocks do not, and a real config carries paragraphs
 * of that prose. An operator who saves one field from the cockpit and finds their
 * whole file rewritten has been given a reason never to use the form again.
 *
 * So the edit is surgical: find the span of the value being set, splice the new
 * one in, and leave every other byte of the file alone. That also means a key the
 * form has never heard of — a comment, a future key, a typo the operator is
 * mid-way through fixing — is carried through untouched rather than dropped.
 *
 * → `docs/spec/02-configuration.md#writing-the-file`
 */
interface ConfigEdits {
  /** Dotted path → new value. A path with no member yet is inserted. */
  set?: Readonly<Record<string, unknown>>;
  /** Dotted paths to remove entirely, so the key falls back to its default. */
  clear?: readonly string[];
}

/** Where a member sits in the text: the key, its value, and the whole member. */
interface Member {
  key: string;
  valueStart: number;
  valueEnd: number;
  memberStart: number;
  memberEnd: number;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i] ?? '')) i++;
  return i;
}

/** Index just past the string literal starting at `i` (which must be a quote). */
function scanString(text: string, i: number): number {
  i++; // opening quote
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  throw new Error('unterminated string');
}

/** Index just past the JSON value starting at `i`. */
function scanValue(text: string, i: number): number {
  i = skipWs(text, i);
  const ch = text[i];
  if (ch === '"') return scanString(text, i);
  if (ch === '{' || ch === '[') {
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = scanString(text, i);
        continue;
      }
      if (c === ch) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error('unterminated object or array');
  }
  // A literal: number, true, false, null. Runs to the next structural character.
  while (i < text.length && !/[,}\]\s]/.test(text[i] ?? '')) i++;
  return i;
}

/** The members of the object whose `{` is at `objStart`, in source order. */
function membersOf(text: string, objStart: number): Member[] {
  const out: Member[] = [];
  let i = skipWs(text, objStart + 1);
  while (i < text.length && text[i] !== '}') {
    if (text[i] !== '"') throw new Error(`expected a key at offset ${i}`);
    const memberStart = i;
    const keyEnd = scanString(text, i);
    const key = JSON.parse(text.slice(memberStart, keyEnd)) as string;
    i = skipWs(text, keyEnd);
    if (text[i] !== ':') throw new Error(`expected ":" after key "${key}"`);
    const valueStart = skipWs(text, i + 1);
    const valueEnd = scanValue(text, valueStart);
    out.push({ key, valueStart, valueEnd, memberStart, memberEnd: valueEnd });
    i = skipWs(text, valueEnd);
    if (text[i] === ',') i = skipWs(text, i + 1);
  }
  return out;
}

/** The offset of the top-level object's `{`. */
function rootStart(text: string): number {
  const i = skipWs(text, 0);
  if (text[i] !== '{') throw new Error('the config file must hold a JSON object');
  return i;
}

/** Walk to the member at `segments`, or report the deepest object that does exist. */
function locate(
  text: string,
  segments: readonly string[],
): { member: Member } | { member: null; ownerStart: number; missing: readonly string[] } {
  let ownerStart = rootStart(text);
  for (let depth = 0; depth < segments.length; depth++) {
    const member = membersOf(text, ownerStart).find((entry) => entry.key === segments[depth]);
    if (!member) return { member: null, ownerStart, missing: segments.slice(depth) };
    if (depth === segments.length - 1) return { member };
    if (text[member.valueStart] !== '{') return { member: null, ownerStart, missing: segments.slice(depth) };
    ownerStart = member.valueStart;
  }
  /* istanbul ignore next — an empty path is refused before it reaches here. */
  throw new Error('empty path');
}

/** The indent of the line `offset` sits on. */
function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  return /^\s*$/.test(line) ? line : '';
}

/** `value` as JSON, with continuation lines indented to sit under `indent`. */
function render(value: unknown, indent: string): string {
  const json = JSON.stringify(value, null, 2);
  return json.split('\n').join(`\n${indent}`);
}

/** Build the nested object a missing path needs, innermost value first. */
function nest(missing: readonly string[], value: unknown): unknown {
  let built = value;
  for (let i = missing.length - 1; i >= 1; i--) built = { [missing[i] ?? '']: built };
  return built;
}

function insertMember(text: string, ownerStart: number, key: string, value: unknown): string {
  const existing = membersOf(text, ownerStart);
  const ownerEnd = scanValue(text, ownerStart) - 1; // the closing brace
  if (existing.length === 0) {
    // An empty object gets the enclosing line's indent plus one step, which is
    // the only place this has to invent formatting rather than copy it.
    const base = indentAt(text, ownerStart);
    const indent = `${base}  `;
    return `${text.slice(0, ownerStart + 1)}\n${indent}${JSON.stringify(key)}: ${render(value, indent)}\n${base}${text.slice(ownerEnd)}`;
  }
  const last = existing[existing.length - 1] as Member;
  const indent = indentAt(text, last.memberStart) || '  ';
  const rendered = `,\n${indent}${JSON.stringify(key)}: ${render(value, indent)}`;
  return `${text.slice(0, last.memberEnd)}${rendered}${text.slice(last.memberEnd)}`;
}

/**
 * Remove a member and exactly one of the commas around it.
 *
 * Which comma matters: dropping the trailing one is right for every member but
 * the last, and dropping the leading one is the only thing that works for the
 * last — take the wrong one and the file no longer parses.
 */
function removeMember(text: string, member: Member): string {
  let start = member.memberStart;
  let end = member.memberEnd;
  const after = skipWs(text, end);
  if (text[after] === ',') {
    end = after + 1;
    // Take the rest of the line with it, so the next member keeps its own indent.
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    if (text[end] === '\n') end++;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (/^\s*$/.test(text.slice(lineStart, start))) start = lineStart;
    return text.slice(0, start) + text.slice(end);
  }
  // The last member: walk back over whitespace to the comma that preceded it.
  let before = start - 1;
  while (before >= 0 && /\s/.test(text[before] ?? '')) before--;
  if (text[before] === ',') start = before;
  else {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (/^\s*$/.test(text.slice(lineStart, start))) start = lineStart;
  }
  return text.slice(0, start) + text.slice(end);
}

/**
 * Apply edits to the config file's *text*.
 *
 * Exported separately from the write so the round trip is testable without a
 * filesystem, and so a caller can show an operator the bytes before committing
 * to them.
 */
export function editConfigText(text: string, edits: ConfigEdits): string {
  let out = text.trim() === '' ? '{}\n' : text;
  for (const path of edits.clear ?? []) {
    const segments = path.split('.');
    const found = locate(out, segments);
    if (found.member) out = removeMember(out, found.member);
    // And the parent it emptied, up as far as the emptiness goes. A clear means
    // "fall back to the layer below", and an empty block does not fall back: a
    // `"ci": {}` left behind still *states* the key, so it replaces the project
    // layer's `ci` with nothing at all — the cleared row promises the team's
    // value returns and it does not. Deepest first, since removing the leaf is
    // what empties the parent.
    for (let depth = segments.length - 1; depth > 0; depth -= 1) {
      const parent = locate(out, segments.slice(0, depth));
      if (!parent.member) break;
      if (!/^\{\s*\}$/.test(out.slice(parent.member.valueStart, parent.member.valueEnd).trim())) break;
      out = removeMember(out, parent.member);
    }
  }
  for (const [path, value] of Object.entries(edits.set ?? {})) {
    const segments = path.split('.');
    const found = locate(out, segments);
    if (found.member) {
      const indent = indentAt(out, found.member.memberStart) || '  ';
      out = out.slice(0, found.member.valueStart) + render(value, indent) + out.slice(found.member.valueEnd);
      continue;
    }
    out = insertMember(out, found.ownerStart, found.missing[0] ?? path, nest(found.missing, value));
  }
  // The one guarantee worth paying a parse for: a save must never leave the
  // harness with a file its next boot cannot read.
  JSON.parse(out);
  return out;
}

/** The file's current text, or an empty object for a deployment that has none. */
export function readConfigText(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}\n';
}

/**
 * Write text back, atomically — a temp file beside it and a rename, so a crash
 * mid-save cannot leave a half-written config. The temp file sits in the same
 * directory on purpose: a rename across filesystems is not atomic.
 *
 * Takes the finished text rather than the edits, because the caller has already
 * had to build it: a save is validated by loading the config the candidate text
 * *would* produce, and editing a second time here would be a second chance to
 * produce different bytes from the ones that were checked.
 */
export function writeConfigText(filePath: string, text: string): void {
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, filePath);
}

/** A fingerprint of the file a form was built from, so a stale save can be refused. */
export function configRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
