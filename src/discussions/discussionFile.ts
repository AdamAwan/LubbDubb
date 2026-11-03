import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  idPrefix,
  parseDiscussion,
  restateEntry,
  setFrontMatterKeys,
  withMissingIds,
} from './parse.js';

// → docs/spec/40-discussions.md

export const DISCUSSION_AUTHORS = {
  operator: 'operator',
  operatorViaClaude: 'operator (via Claude)',
  claudeSuggested: 'Claude (suggested)',
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

export type DiscussionWrite = { ok: true; entry: DiscussionEntry; path: string } | Refusal;

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

function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DiscussionFiles {
  private readonly folder: string | null;
  private readonly now: () => Date;
  private readonly reportedDuplicates = new Set<string>();

  constructor(private readonly deps: DiscussionFilesDeps) {
    this.folder = deps.dir === undefined || deps.dir.trim() === '' ? null : join(deps.dir, deps.repo);
    this.now = deps.now ?? ((): Date => new Date());
  }

  get enabled(): boolean {
    return this.folder !== null;
  }

  locate(number: number): string | null {
    if (this.folder === null || !existsSync(this.folder)) return null;
    const matches = readdirSync(this.folder, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md') && Number(LEADING_NUMBER.exec(d.name)?.[1]) === number)
      .map((d) => join(this.folder!, d.name));
    if (matches.length <= 1) return matches[0] ?? null;
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

  read(number: number): DiscussionDocument | null {
    if (this.folder === null) return null;
    try {
      const path = this.locate(number);
      if (path === null) return null;
      return { path, ...parseDiscussion(readFileSync(path, 'utf8')) };
    } catch (error) {
      this.deps.errors.record({
        source: 'server',
        message: `The discussion file for #${number} could not be read; it is treated as absent.`,
        detail: failure(error),
      });
      return null;
    }
  }

  add(subject: DiscussionSubject, input: NewDiscussionEntry): DiscussionWrite {
    return this.write(subject.number, 'add to', () => {
      const path = this.locate(subject.number) ?? this.create(subject);
      const before = existsSync(path) ? readFileSync(path, 'utf8') : this.header(subject);
      return this.append(path, before, input);
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

  setFrontMatter(number: number, keys: { published?: string; pulled?: string }): { ok: true; path: string } | Refusal {
    return this.write(number, 'update', () => {
      const path = this.locate(number);
      if (path === null) return { ok: false, error: `There is no discussion file for #${number}.` };
      const values = Object.fromEntries(Object.entries(keys).filter((pair): pair is [string, string] => !!pair[1]));
      const next = setFrontMatterKeys(this.withIds(readFileSync(path, 'utf8')), values);
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
    if (this.folder === null) return { ok: false, error: 'Discussions are off: discussionsDir is not set.' };
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
    const id = this.mint(input.kind, entryIds(text));
    const stateful = input.kind === 'idea' || input.kind === 'question';
    const block = formatEntry({
      kind: input.kind,
      state: stateful ? (input.state ?? 'open') : null,
      date: localDate(this.now()),
      author: cleanAuthor(input.author) || 'unknown',
      id,
      body: input.body,
    });
    return this.commit(path, appendBlock(text, block), id);
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
      const id = `${idPrefix(kind)}-${randomBytes(2).toString('hex')}`;
      if (!taken.has(id)) return id;
    }
  }

  private replace(path: string, text: string): void {
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
