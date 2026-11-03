import type {
  DiscussionEntry,
  DiscussionEntryState,
  DiscussionFrontMatter,
  DiscussionKind,
  DiscussionSubjectKind,
} from '../types.js';

// → docs/spec/40-discussions.md#the-file

const STATES: Record<DiscussionKind, readonly DiscussionEntryState[]> = {
  note: [],
  idea: ['open', 'accepted', 'parked', 'dropped'],
  question: ['open', 'answered'],
  decision: [],
};

export const DISCUSSION_KINDS = ['note', 'idea', 'question', 'decision'] as const satisfies readonly DiscussionKind[];

export const ID_PREFIX: Record<DiscussionKind, string> = { note: 'n', idea: 'i', question: 'q', decision: 'd' };

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

const HEADING = /^##(?:[ \t]+(.*))?$/;
const TRAILING_ID = /\s+\^([A-Za-z0-9-]+)\s*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const ANSWER = /^Answer:\s*(.*)$/;
const SUPERSEDES = /Supersedes\s+\^([A-Za-z0-9-]+)/g;
const FRONT_KEY = /^([A-Za-z0-9_-]+):(.*)$/;

interface HeadingParts {
  kind: DiscussionKind;
  state: DiscussionEntryState | null;
  date: string;
  author: string;
  id: string | null;
}

interface Block {
  headingLine: number;
  end: number;
}

interface Lines {
  lines: string[];
  eol: string;
  bodyStart: number;
  frontEnd: number | null;
}

function bare(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function splitLines(text: string): Lines {
  const lines = text.split('\n');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let frontEnd: number | null = null;
  if (lines.length > 1 && bare(lines[0]!).trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const t = bare(lines[i]!).trim();
      if (t === '---' || t === '...') {
        frontEnd = i;
        break;
      }
    }
  }
  return { lines, eol, frontEnd, bodyStart: frontEnd === null ? 0 : frontEnd + 1 };
}

function blocks({ lines, bodyStart }: Lines): Block[] {
  const found: Block[] = [];
  let fence: string | null = null;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = bare(lines[i]!);
    const opener = FENCE.exec(line)?.[1];
    if (opener !== undefined) {
      if (fence === null) fence = opener[0]!;
      else if (opener[0] === fence) fence = null;
      continue;
    }
    if (fence === null && HEADING.test(line)) {
      const last = found.at(-1);
      if (last) last.end = i;
      found.push({ headingLine: i, end: lines.length });
    }
  }
  return found;
}

function parseHeading(text: string): HeadingParts | null {
  let rest = text.trim();
  let id: string | null = null;
  const idMatch = TRAILING_ID.exec(` ${rest}`);
  if (idMatch) {
    id = idMatch[1]!;
    rest = ` ${rest}`.slice(0, idMatch.index).trim();
  }
  const parts = rest.split(/\s*·\s*/);
  const kind = (parts[0] ?? '').toLowerCase();
  if (!isOneOf(kind, DISCUSSION_KINDS) || (parts.length !== 3 && parts.length !== 4)) return null;
  const written = parts.length === 4 ? parts[1]!.toLowerCase() : null;
  const allowed = STATES[kind];
  if (written !== null && !allowed.includes(written as DiscussionEntryState)) return null;
  const state = written === null && allowed.length > 0 ? 'open' : (written as DiscussionEntryState | null);
  const date = parts[parts.length - 2]!;
  const author = parts[parts.length - 1]!;
  if (!DATE.test(date) || author === '') return null;
  return { kind, state, date, author, id };
}

function splitAnswer(body: string[]): { body: string; answer: string | null } {
  let fence = false;
  for (let i = 0; i < body.length; i++) {
    if (FENCE.test(body[i]!)) fence = !fence;
    const match = fence ? null : ANSWER.exec(body[i]!);
    if (match) {
      const answer = [match[1]!, ...body.slice(i + 1)].join('\n').trim();
      return { body: body.slice(0, i).join('\n').trim(), answer };
    }
  }
  return { body: body.join('\n').trim(), answer: null };
}

function entryOf(lines: string[], block: Block): DiscussionEntry {
  const heading = (HEADING.exec(bare(lines[block.headingLine]!))?.[1] ?? '').trim();
  const bodyLines = lines.slice(block.headingLine + 1, block.end).map(bare);
  const parts = parseHeading(heading);
  if (parts === null) {
    const id = TRAILING_ID.exec(` ${heading}`)?.[1] ?? null;
    const body = bodyLines.join('\n').trim();
    return {
      kind: 'note',
      state: null,
      date: null,
      author: null,
      id,
      heading,
      body,
      answer: null,
      supersedes: [],
      unreadable: true,
    };
  }
  const { body, answer } =
    parts.kind === 'question' ? splitAnswer(bodyLines) : { body: bodyLines.join('\n').trim(), answer: null };
  const supersedes = parts.kind === 'decision' ? [...body.matchAll(SUPERSEDES)].map((m) => m[1]!) : [];
  return { ...parts, heading, body, answer, supersedes, unreadable: false };
}

function scalar(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith("'")) {
    const end = value.lastIndexOf("'");
    return end > 0 ? value.slice(1, end).replace(/''/g, "'") : value.slice(1);
  }
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"');
    return end > 0 ? value.slice(1, end).replace(/\\"/g, '"') : value.slice(1);
  }
  const plain = value.replace(/\s+#.*$/, '').trim();
  return plain === '' || plain === '~' || plain === 'null' ? null : plain;
}

function frontValues(split: Lines): Map<string, string | null> {
  const values = new Map<string, string | null>();
  if (split.frontEnd === null) return values;
  for (const line of split.lines.slice(1, split.frontEnd)) {
    const match = FRONT_KEY.exec(bare(line));
    if (match) values.set(match[1]!, scalar(match[2]!));
  }
  return values;
}

function frontMatterOf(split: Lines): DiscussionFrontMatter {
  const values = frontValues(split);
  const kind = values.get('kind');
  const parent = values.get('parent') ?? null;
  const parentNumber = parent === null ? null : /\[\[\s*(\d+)/.exec(parent)?.[1];
  return {
    ref: values.get('ref') ?? null,
    kind: kind === 'story' || kind === 'feature' ? (kind as DiscussionSubjectKind) : null,
    title: values.get('title') ?? null,
    parent,
    parentNumber: parentNumber == null ? null : Number(parentNumber),
    published: values.get('published') ?? null,
    pulled: values.get('pulled') ?? null,
  };
}

export function parseDiscussion(text: string): { frontMatter: DiscussionFrontMatter; entries: DiscussionEntry[] } {
  const split = splitLines(text);
  return { frontMatter: frontMatterOf(split), entries: blocks(split).map((block) => entryOf(split.lines, block)) };
}

function yamlScalar(value: string): string {
  const plain =
    /^[A-Za-z0-9_][A-Za-z0-9_ ./:@+-]*$/.test(value) &&
    !value.includes(': ') &&
    !value.endsWith(' ') &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(value);
  return plain ? value : `'${value.replace(/'/g, "''")}'`;
}

export function setFrontMatterKeys(text: string, keys: Readonly<Record<string, string>>): string {
  const split = splitLines(text);
  const { lines, eol } = split;
  if (split.frontEnd === null) {
    const front = ['---', ...Object.entries(keys).map(([key, value]) => `${key}: ${yamlScalar(value)}`), '---'];
    return front.join(eol) + eol + text;
  }
  let end = split.frontEnd;
  for (const [key, value] of Object.entries(keys)) {
    const line = `${key}: ${yamlScalar(value)}${eol === '\r\n' ? '\r' : ''}`;
    const at = lines.findIndex((l, i) => i > 0 && i < end && bare(l).startsWith(`${key}:`));
    if (at === -1) {
      lines.splice(end, 0, line);
      end += 1;
      continue;
    }
    let continued = at + 1;
    while (continued < end && /^(\s+\S|-\s)/.test(bare(lines[continued]!))) continued += 1;
    lines.splice(at, continued - at, line);
    end -= continued - at - 1;
  }
  return lines.join('\n');
}

function formatHeading(parts: HeadingParts): string {
  const kind = parts.kind[0]!.toUpperCase() + parts.kind.slice(1);
  const segments = [kind, ...(parts.state === null ? [] : [parts.state]), parts.date, parts.author];
  return `## ${segments.join(' · ')}${parts.id === null ? '' : ` ^${parts.id}`}`;
}

export function cleanAuthor(author: string): string {
  return author
    .replace(/[·^\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanBody(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.replace(/\r\n/g, '\n').trim().split('\n')) {
    const opener = FENCE.exec(line)?.[1];
    if (opener !== undefined) {
      if (fence === null) fence = opener[0]!;
      else if (opener[0] === fence) fence = null;
      out.push(line);
    } else out.push(fence === null && HEADING.test(line) ? `\\${line}` : line);
  }
  if (fence !== null) out.push(fence.repeat(3));
  return out.join('\n');
}

interface FormattedEntry extends HeadingParts {
  body: string;
}

export function formatEntry(entry: FormattedEntry): string {
  return `${formatHeading(entry)}\n\n${cleanBody(entry.body)}\n`;
}

export function appendBlock(text: string, block: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const own = block.replace(/\n/g, eol);
  if (text.trim() === '') return text + own;
  const ended = text.endsWith(eol) ? text : text + eol;
  return ended.endsWith(eol + eol) ? ended + own : ended + eol + own;
}

export function entryIds(text: string): Set<string> {
  return new Set(parseDiscussion(text).entries.flatMap((entry) => (entry.id === null ? [] : [entry.id])));
}

export function withMissingIds(text: string, mint: (kind: DiscussionKind) => string): string {
  const split = splitLines(text);
  let changed = false;
  for (const block of blocks(split)) {
    const entry = entryOf(split.lines, block);
    if (entry.unreadable || entry.id !== null) continue;
    const line = split.lines[block.headingLine]!;
    const cr = line.endsWith('\r') ? '\r' : '';
    split.lines[block.headingLine] = `${bare(line).trimEnd()} ^${mint(entry.kind)}${cr}`;
    changed = true;
  }
  return changed ? split.lines.join('\n') : text;
}

export function restateEntry(
  text: string,
  id: string,
  state: DiscussionEntryState,
  appended: string | null,
): string | null {
  const split = splitLines(text);
  const block = blocks(split).find((b) => entryOf(split.lines, b).id === id);
  if (block === undefined) return null;
  const entry = entryOf(split.lines, block);
  if (entry.unreadable || entry.date === null || entry.author === null) return null;
  const { lines } = split;
  const cr = lines[block.headingLine]!.endsWith('\r') ? '\r' : '';
  lines[block.headingLine] =
    formatHeading({ kind: entry.kind, state, date: entry.date, author: entry.author, id }) + cr;
  if (appended !== null) {
    let last = block.end - 1;
    while (last > block.headingLine && bare(lines[last]!).trim() === '') last -= 1;
    const added = ['', ...cleanBody(appended).split('\n')].map((l) => l + cr);
    lines.splice(last + 1, 0, ...added);
  }
  return lines.join('\n');
}
