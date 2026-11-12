import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Config } from '../config/config.js';
import type { ErrorRecorder } from '../errorLog.js';
import type {
  DiscussionDocument,
  DiscussionEntry,
  DiscussionEntryState,
  DiscussionKind,
  DiscussionSubjectKind,
} from '../types.js';
import {
  appendBlock,
  cleanAuthor,
  entryIds,
  formatEntry,
  ID_PREFIX,
  parseDiscussion,
  restateEntry,
  setFrontMatterKeys,
  withMissingIds,
} from './parse.js';

// → docs/spec/40-discussions.md

export const DISCUSSIONS_OFF = 'Discussions are off: discussionsDir is not set in lubbdubb.config.json.';

export const DISCUSSION_AUTHORS = {
  operatorViaClaude: 'operator (via Claude)',
  claudeSuggested: 'Claude (suggested)',
  watch: 'LubbDubb (watch)',
  agent: (rule: string, taskId: string): string => `agent ${rule}#${taskId}`,
  tracker: (login: string): string => `@${login} (tracker)`,
} as const;

export interface DiscussionSubject {
  number: number;
  title: string;
  kind: DiscussionSubjectKind;
  parent?: { number: number; title: string } | null;
}

export interface NewDiscussionEntry {
  kind: DiscussionKind;
  body: string;
  author: string;
  state?: DiscussionEntryState;
}

export type DiscussionSettlement =
  | { action: 'answer'; answer: string }
  | { action: 'accept' | 'park' | 'drop'; note?: string }
  | { action: 'supersede'; body: string; author: string };

type Refusal = { ok: false; error: string };

type FrontMatterKeys = { published?: string; pulled?: string };

type DiscussionWrite = { ok: true; entry: DiscussionEntry; path: string } | Refusal;

export interface DiscussionFilesDeps {
  dir: string | undefined;
  repo: string;
  errors: ErrorRecorder;
  now?: () => Date;
}

const IDEA_STATES = { accept: 'accepted', park: 'parked', drop: 'dropped' } as const;

const LEADING_NUMBER = /^(\d+)(?!\d)/;

export function discussionRepoFolder(config: Pick<Config, 'github' | 'azureDevOps' | 'repoRoot'>): string {
  const named = [config.github?.repo, config.azureDevOps?.repository].find(
    (name): name is string => name !== undefined && name.trim() !== '',
  );
  return fileSafe(named ?? basename(config.repoRoot)) || 'repo';
}

function fileSafe(text: string): string {
  return text
    .replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
}

function discussionFileName(number: number, title: string): string {
  const slug = fileSafe(title);
  return slug === '' ? `${number}` : `${number} ${slug}`;
}

function definedKeys(keys: FrontMatterKeys): Record<string, string> {
  return Object.fromEntries(Object.entries(keys).filter((pair): pair is [string, string] => !!pair[1]));
}

function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Listing {
  mtimeMs: number;
  listedAt: number;
  paths: Map<number, string>;
}

const COARSE_CLOCK_MS = 2000;

interface Parsed {
  mtimeMs: number;
  size: number;
  doc: DiscussionDocument;
}

function vaultRoot(folder: string): string | null {
  let dir = folder;
  for (;;) {
    const marker = join(dir, '.obsidian');
    if (existsSync(marker) && statSync(marker).isDirectory()) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export class DiscussionFiles {
  private readonly folder: string | null;
  private readonly now: () => Date;
  private readonly reportedDuplicates = new Set<string>();
  private listed: Listing | null = null;
  private readonly parsed = new Map<string, Parsed>();
  private vault: string | null | undefined;

  constructor(private readonly deps: DiscussionFilesDeps) {
    this.folder = deps.dir === undefined || deps.dir.trim() === '' ? null : join(deps.dir, deps.repo);
    this.now = deps.now ?? ((): Date => new Date());
  }

  get enabled(): boolean {
    return this.folder !== null;
  }

  locate(number: number): string | null {
    return this.listing().get(number) ?? null;
  }

  /** Throws on an unreadable folder; the caller records it. */
  numbers(): number[] {
    return [...this.listing().keys()].sort((a, b) => a - b);
  }

  read(number: number): DiscussionDocument | null {
    if (this.folder === null) return null;
    try {
      const path = this.locate(number);
      if (path === null) return null;
      const fd = openSync(path, 'r');
      try {
        const stat = fstatSync(fd);
        const cached = this.parsed.get(path);
        const settled = Date.now() - stat.mtimeMs > COARSE_CLOCK_MS;
        if (settled && cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.doc;
        const doc = { path, ...parseDiscussion(readFileSync(fd, 'utf8')) };
        this.parsed.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, doc });
        return doc;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      this.deps.errors.record({
        source: 'server',
        message: `The discussion file for #${number} could not be read; it is treated as absent.`,
        detail: failure(error),
      });
      return null;
    }
  }

  obsidianUrl(path: string): string | null {
    if (this.folder === null) return null;
    if (this.vault === undefined) this.vault = vaultRoot(this.folder);
    return this.vault === null ? null : `obsidian://open?path=${encodeURIComponent(path)}`;
  }

  add(subject: DiscussionSubject, input: NewDiscussionEntry): DiscussionWrite {
    return this.write(subject.number, 'add to', () => {
      const path = this.locateFresh(subject.number) ?? this.create(subject);
      const before = existsSync(path) ? readFileSync(path, 'utf8') : this.header(subject);
      return this.append(path, before, input);
    });
  }

  addMany(
    subject: DiscussionSubject,
    inputs: readonly NewDiscussionEntry[],
    keys: FrontMatterKeys = {},
  ): { ok: true; path: string } | Refusal {
    return this.write(subject.number, 'add to', () => {
      const path = this.locateFresh(subject.number) ?? this.create(subject);
      let text = this.withIds(existsSync(path) ? readFileSync(path, 'utf8') : this.header(subject));
      const taken = entryIds(text);
      for (const input of inputs) text = appendBlock(text, this.block(input, taken).block);
      this.replace(path, setFrontMatterKeys(text, definedKeys(keys)));
      return { ok: true, path };
    });
  }

  settle(number: number, id: string, settlement: DiscussionSettlement): DiscussionWrite {
    return this.write(number, 'settle an entry in', () => {
      const path = this.locate(number);
      if (path === null) return { ok: false, error: `There is no discussion file for #${number}.` };
      const text = this.withIds(readFileSync(path, 'utf8'));
      const entry = parseDiscussion(text).entries.find((e) => e.id === id && !e.unreadable);
      if (entry === undefined) return { ok: false, error: `#${number}'s discussion has no readable entry ^${id}.` };
      if (settlement.action === 'supersede') {
        if (entry.kind !== 'decision') return { ok: false, error: `^${id} is a ${entry.kind}, not a decision.` };
        const body = `${settlement.body.trim()}\n\nSupersedes ^${id}`;
        return this.append(path, text, { kind: 'decision', body, author: settlement.author });
      }
      const restated = this.restate(entry, settlement);
      if (!restated.ok) return restated;
      const next = restateEntry(text, id, restated.state, restated.appended);
      if (next === null) return { ok: false, error: `^${id} could not be rewritten.` };
      return this.commit(path, next, id);
    });
  }

  identify(number: number): { ok: true; path: string | null; changed: boolean } | Refusal {
    return this.write(number, 'name the entries of', () => {
      const path = this.locate(number);
      if (path === null) return { ok: true, path: null, changed: false };
      const text = readFileSync(path, 'utf8');
      const named = this.withIds(text);
      if (named !== text) this.replace(path, named);
      return { ok: true, path, changed: named !== text };
    });
  }

  setFrontMatter(number: number, keys: FrontMatterKeys): { ok: true; path: string } | Refusal {
    return this.write(number, 'update', () => {
      const path = this.locate(number);
      if (path === null) return { ok: false, error: `There is no discussion file for #${number}.` };
      const next = setFrontMatterKeys(this.withIds(readFileSync(path, 'utf8')), definedKeys(keys));
      this.replace(path, next);
      return { ok: true, path };
    });
  }

  private restate(
    entry: DiscussionEntry,
    settlement: Exclude<DiscussionSettlement, { action: 'supersede' }>,
  ): { ok: true; state: DiscussionEntryState; appended: string | null } | { ok: false; error: string } {
    if (settlement.action === 'answer') {
      if (entry.kind !== 'question') return { ok: false, error: `^${entry.id} is a ${entry.kind}, not a question.` };
      if (entry.state === 'answered') return { ok: false, error: `^${entry.id} is already answered.` };
      return { ok: true, state: 'answered', appended: `Answer: ${settlement.answer.trim()}` };
    }
    if (entry.kind !== 'idea') return { ok: false, error: `^${entry.id} is a ${entry.kind}, not an idea.` };
    const note = settlement.note?.trim();
    return { ok: true, state: IDEA_STATES[settlement.action], appended: note ? note : null };
  }

  private write<T>(number: number, verb: string, run: () => T | Refusal): T | Refusal {
    if (this.folder === null) return { ok: false, error: DISCUSSIONS_OFF };
    try {
      return run();
    } catch (error) {
      this.deps.errors.record({
        source: 'server',
        message: `Could not ${verb} the discussion file for #${number}.`,
        detail: failure(error),
      });
      return { ok: false, error: `Could not ${verb} the discussion file for #${number}: ${failure(error)}` };
    }
  }

  private create(subject: DiscussionSubject): string {
    mkdirSync(this.folder!, { recursive: true });
    return join(this.folder!, `${discussionFileName(subject.number, subject.title)}.md`);
  }

  private header(subject: DiscussionSubject): string {
    const keys: Record<string, string> = {
      ref: `issue:${subject.number}`,
      kind: subject.kind,
      title: subject.title,
    };
    if (subject.kind === 'story' && subject.parent) {
      keys.parent = `[[${discussionFileName(subject.parent.number, subject.parent.title)}]]`;
    }
    return setFrontMatterKeys('', keys);
  }

  private append(path: string, before: string, input: NewDiscussionEntry): DiscussionWrite {
    const text = this.withIds(before);
    const { id, block } = this.block(input, entryIds(text));
    return this.commit(path, appendBlock(text, block), id);
  }

  private block(input: NewDiscussionEntry, taken: Set<string>): { id: string; block: string } {
    const id = this.mint(input.kind, taken);
    taken.add(id);
    const stateful = input.kind === 'idea' || input.kind === 'question';
    const block = formatEntry({
      kind: input.kind,
      state: stateful ? (input.state ?? 'open') : null,
      date: localDate(this.now()),
      author: cleanAuthor(input.author) || 'unknown',
      id,
      body: input.body,
    });
    return { id, block };
  }

  private commit(path: string, text: string, id: string): DiscussionWrite {
    this.replace(path, text);
    const entry = parseDiscussion(text).entries.find((e) => e.id === id);
    return entry === undefined ? { ok: false, error: `^${id} did not survive the write.` } : { ok: true, entry, path };
  }

  private withIds(text: string): string {
    const taken = entryIds(text);
    return withMissingIds(text, (kind) => {
      const id = this.mint(kind, taken);
      taken.add(id);
      return id;
    });
  }

  private mint(kind: DiscussionKind, taken: ReadonlySet<string>): string {
    for (;;) {
      const id = `${ID_PREFIX[kind]}-${randomBytes(2).toString('hex')}`;
      if (!taken.has(id)) return id;
    }
  }

  private listing(): Map<number, string> {
    if (this.folder === null || !existsSync(this.folder)) return new Map();
    const mtimeMs = statSync(this.folder).mtimeMs;
    const listed = this.listed;
    if (listed?.mtimeMs === mtimeMs && listed.listedAt - mtimeMs > COARSE_CLOCK_MS) return listed.paths;
    const listedAt = Date.now();
    const found = new Map<number, string[]>();
    for (const d of readdirSync(this.folder, { withFileTypes: true })) {
      const number = Number(LEADING_NUMBER.exec(d.name)?.[1]);
      if (!d.isFile() || !d.name.endsWith('.md') || !Number.isInteger(number) || number <= 0) continue;
      found.set(number, [...(found.get(number) ?? []), join(this.folder, d.name)]);
    }
    const paths = new Map([...found].map(([number, matches]) => [number, this.oldest(number, matches)]));
    this.listed = { mtimeMs, listedAt, paths };
    const named = new Set(paths.values());
    for (const path of this.parsed.keys()) if (!named.has(path)) this.parsed.delete(path);
    return paths;
  }

  private locateFresh(number: number): string | null {
    this.listed = null;
    return this.locate(number);
  }

  private oldest(number: number, matches: string[]): string {
    if (matches.length === 1) return matches[0]!;
    const born = (path: string): number => {
      const stat = statSync(path);
      return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    };
    const ordered = matches.sort((a, b) => born(a) - born(b) || a.localeCompare(b));
    const key = ordered.join('\n');
    if (!this.reportedDuplicates.has(key)) {
      this.reportedDuplicates.add(key);
      this.deps.errors.record({
        source: 'server',
        message: `Two discussion files lead with #${number}; reading the older, ${basename(ordered[0]!)}.`,
        detail: ordered.join('\n'),
      });
    }
    return ordered[0]!;
  }

  private replace(path: string, text: string): void {
    this.listed = null;
    this.parsed.delete(path);
    const temp = join(this.folder!, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(temp, text, 'utf8');
    try {
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
