import { createHash } from 'node:crypto';
import { DAY_MS } from '../primitives.js';
import { upstreamIssueUrl } from '../tickets/upstream.js';
import type { ErrorLogEntry } from '../types.js';
import type { FaultReport } from '../wire.js';
import { errorClass, harnessFrames, isKnown, scrubText, wordsOf, type HarnessFrame } from './scrub.js';

// → docs/spec/18-observability.md#reporting-a-fault-to-lubbdubb

const MAX_TITLE = 120;

export interface ReportContext {
  root: string;
  vocabulary: ReadonlySet<string>;
  leaks: readonly string[];
  build: string;
  runtime: string;
  now: string;
}

interface Group {
  source: ErrorLogEntry['source'];
  message: string;
  errorClass: string | null;
  frames: HarnessFrame[];
  where: string | null;
  count: number;
  first: string;
}

export function composeFaultReports(entries: readonly ErrorLogEntry[], ctx: ReportContext): FaultReport[] {
  const groups = new Map<string, Group>();
  const scrubbed = new Map<string, { key: string; group: Omit<Group, 'count' | 'first'> }>();
  for (const entry of entries) {
    const raw = `${entry.source}\u0000${entry.message}\u0000${entry.detail ?? ''}`;
    let shape = scrubbed.get(raw);
    if (!shape) {
      const frames = harnessFrames(entry.detail, ctx.root, ctx.vocabulary);
      const top = frames[0];
      const group = {
        source: entry.source,
        message: scrubText(entry.message, ctx.vocabulary),
        errorClass: errorClass(entry.detail, ctx.vocabulary),
        frames,
        where: top ? `${top.file}:${top.line}` : null,
      };
      shape = { key: [group.source, group.message, group.errorClass ?? '', group.where ?? ''].join('\u0000'), group };
      scrubbed.set(raw, shape);
    }
    const group = groups.get(shape.key);
    if (group) {
      group.count++;
      if (entry.createdAt < group.first) group.first = entry.createdAt;
    } else groups.set(shape.key, { ...shape.group, count: 1, first: entry.createdAt });
  }
  return [...groups.entries()]
    .map(([key, group]) => report(key, group, ctx))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

function report(key: string, group: Group, ctx: ReportContext): FaultReport {
  const head = {
    fingerprint: createHash('sha256').update(key).digest('hex').slice(0, 12),
    source: group.source,
    count: group.count,
  };
  const title = clip(`Fault report: ${group.source} — ${group.message || '(message withheld)'}`, MAX_TITLE);
  const body = composeBody(group, ctx, head.fingerprint);
  if (findLeak(`${title}\n${body}`, ctx.leaks) !== null)
    return {
      ...head,
      title: '',
      body: '',
      issueUrl: null,
      withheld: 'something specific to this install survived scrubbing, so nothing was composed',
    };
  return { ...head, title, body, issueUrl: upstreamIssueUrl(title, body), withheld: null };
}

function composeBody(group: Group, ctx: ReportContext, fingerprint: string): string {
  const days = Math.max(0, Math.floor((Date.parse(ctx.now) - Date.parse(group.first)) / DAY_MS));
  const lines = [
    '_Reported from a LubbDubb fault log. Every word below was checked against LubbDubb’s own source; anything else was removed before it left the machine._',
    '',
    `- **Where:** \`${group.source}\`${group.where ? ` at \`${group.where}\`` : ''}`,
    `- **Seen:** ${group.count} ${group.count === 1 ? 'time' : 'times'}, first ${days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} ago`}`,
    `- **Build:** \`${ctx.build}\` · ${ctx.runtime}`,
    `- **Fingerprint:** \`${fingerprint}\``,
    '',
    '### Message',
    '',
    '```',
    [group.errorClass, group.message].filter(Boolean).join(': ') || '(message withheld)',
    '```',
  ];
  if (group.frames.length > 0) {
    lines.push('', '### LubbDubb frames', '', '```');
    for (const f of group.frames) lines.push(`${f.fn ?? '(anonymous)'}  ${f.file}:${f.line}`);
    lines.push('```');
  }
  lines.push('', '### Where to start', '', ...suggestion(group));
  return lines.join('\n');
}

function suggestion(group: Group): string[] {
  const out: string[] = [];
  if (group.where) out.push(`- Read \`${group.where}\`, and the spec its file's header points to.`);
  out.push(`- ${SOURCE_HINT[group.source]}`);
  if (group.message.includes('‹'))
    out.push('- Values in ‹…› were withheld by the reporter; reproduce before guessing at them.');
  return out;
}

const SOURCE_HINT: Record<ErrorLogEntry['source'], string> = {
  cycle: 'A cycle-level failure: check the harness cycle’s catch and what it called (docs/spec/04-harness-cycle.md).',
  provider: 'A provider failure: check the integration and its retry path (docs/spec/15-integrations.md).',
  agent: 'An agent failure: check the agent runtime, spawn and reaping (docs/spec/10-agent-runtimes.md).',
  server: 'A route threw: check the route’s validation and error handling (docs/spec/16-http-api.md).',
  boot: 'A boot failure: check restore and orphan handling (docs/spec/04-harness-cycle.md).',
  runtime:
    'A runtime-watch reading: a blocked loop or slow store read (docs/spec/18-observability.md#the-runtime-watch).',
};

export function leakTerms(instanceTerms: readonly string[], vocabulary: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const term of instanceTerms)
    for (const word of wordsOf(term)) if (word.length >= 3 && !isKnown(word, vocabulary)) out.add(word.toLowerCase());
  return [...out];
}

export function findLeak(text: string, leaks: readonly string[]): string | null {
  const words = new Set(wordsOf(text).map((w) => w.toLowerCase()));
  return leaks.find((leak) => words.has(leak)) ?? null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
