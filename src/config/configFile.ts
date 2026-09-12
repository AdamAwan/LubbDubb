import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

// → docs/spec/02-configuration.md

interface ConfigEdits {
  set?: Readonly<Record<string, unknown>>;
  clear?: readonly string[];
}

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

function scanString(text: string, i: number): number {
  i++;
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
  while (i < text.length && !/[,}\]\s]/.test(text[i] ?? '')) i++;
  return i;
}

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

function rootStart(text: string): number {
  const i = skipWs(text, 0);
  if (text[i] !== '{') throw new Error('the config file must hold a JSON object');
  return i;
}

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

function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  return /^\s*$/.test(line) ? line : '';
}

function render(value: unknown, indent: string): string {
  const json = JSON.stringify(value, null, 2);
  return json.split('\n').join(`\n${indent}`);
}

function nest(missing: readonly string[], value: unknown): unknown {
  let built = value;
  for (let i = missing.length - 1; i >= 1; i--) built = { [missing[i] ?? '']: built };
  return built;
}

function insertMember(text: string, ownerStart: number, key: string, value: unknown): string {
  const existing = membersOf(text, ownerStart);
  const ownerEnd = scanValue(text, ownerStart) - 1;
  if (existing.length === 0) {
    const base = indentAt(text, ownerStart);
    const indent = `${base}  `;
    return `${text.slice(0, ownerStart + 1)}\n${indent}${JSON.stringify(key)}: ${render(value, indent)}\n${base}${text.slice(ownerEnd)}`;
  }
  const last = existing[existing.length - 1] as Member;
  const indent = indentAt(text, last.memberStart) || '  ';
  const rendered = `,\n${indent}${JSON.stringify(key)}: ${render(value, indent)}`;
  return `${text.slice(0, last.memberEnd)}${rendered}${text.slice(last.memberEnd)}`;
}

function removeMember(text: string, member: Member): string {
  let start = member.memberStart;
  let end = member.memberEnd;
  const after = skipWs(text, end);
  if (text[after] === ',') {
    end = after + 1;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    if (text[end] === '\n') end++;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (/^\s*$/.test(text.slice(lineStart, start))) start = lineStart;
    return text.slice(0, start) + text.slice(end);
  }
  let before = start - 1;
  while (before >= 0 && /\s/.test(text[before] ?? '')) before--;
  if (text[before] === ',') start = before;
  else {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (/^\s*$/.test(text.slice(lineStart, start))) start = lineStart;
  }
  return text.slice(0, start) + text.slice(end);
}

export function editConfigText(text: string, edits: ConfigEdits): string {
  let out = text.trim() === '' ? '{}\n' : text;
  for (const path of edits.clear ?? []) {
    const segments = path.split('.');
    const found = locate(out, segments);
    if (found.member) out = removeMember(out, found.member);
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
  JSON.parse(out);
  return out;
}

export function readConfigText(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '{}\n';
}

export function writeConfigText(filePath: string, text: string): void {
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, filePath);
}

export function configRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
