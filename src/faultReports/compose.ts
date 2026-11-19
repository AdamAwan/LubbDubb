import { createHash } from 'node:crypto';
import type { ErrorLogEntry, FaultReport } from '../types.js';
import { errorClass, harnessFrames, isKnown, scrubText, wordsOf, type HarnessFrame } from './scrub.js';

// → docs/spec/18-observability.md#reporting-a-fault-to-lubbdubb

const MAX_TITLE = 120;
const MAX_URL = 7500;
const DAY_MS = 86_400_000;

export interface ReportContext {
  root: string;
  vocabulary: ReadonlySet<string>;
  instanceTerms: readonly string[];
  newIssueBase: string;
  build: string;
  runtime: string;
  now: string;
}

interface Group {
  source: ErrorLogEntry['source'];
  message: string;
  errorClass: string | null;
  frames: HarnessFrame[];
  count: number;
  first: string;
  last: string;
}

export function composeFaultReports(entries: readonly ErrorLogEntry[], ctx: ReportContext): FaultReport[] {
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const message = scrubText(entry.message, ctx.vocabulary);
    const frames = harnessFrames(entry.detail, ctx.root, ctx.vocabulary);
    const cls = errorClass(entry.detail, ctx.vocabulary);
    const top = frames[0];
    const key = [entry.source, message, cls ?? '', top ? `${top.file}:${top.line}` : ''].join('\u0000');
    const group = groups.get(key);
    if (group) {
      group.count++;
      if (entry.createdAt < group.first) group.first = entry.createdAt;
      if (entry.createdAt > group.last) group.last = entry.createdAt;
    } else {
      groups.set(key, {
        source: entry.source,
        message,
        errorClass: cls,
        frames,
        count: 1,
        first: entry.createdAt,
        last: entry.createdAt,
      });
    }
  }
  const leaks = leakTerms(ctx.instanceTerms, ctx.vocabulary);
  return [...groups.entries()]
    .map(([key, group]) => report(key, group, ctx, leaks))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

function report(key: string, group: Group, ctx: ReportContext, leaks: readonly string[]): FaultReport {
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 12);
  const headline = group.message === '' ? '(message withheld)' : group.message;
  const title = clip(`Fault report: ${group.source} — ${headline}`, MAX_TITLE);
  const body = composeBody(group, ctx, fingerprint);
  if (findLeak(`${title}\n${body}`, leaks) !== null)
    return {
      fingerprint,
      source: group.source,
      count: group.count,
      title: '',
      body: '',
      issueUrl: null,
      withheld: 'something specific to this install survived scrubbing, so nothing was composed',
    };
  return {
    fingerprint,
    source: group.source,
    count: group.count,
    title,
    body,
    issueUrl: newIssueUrl(ctx.newIssueBase, title, body),
    withheld: null,
  };
}

function composeBody(group: Group, ctx: ReportContext, fingerprint: string): string {
  const days = Math.max(0, Math.floor((Date.parse(ctx.now) - Date.parse(group.first)) / DAY_MS));
  const top = group.frames[0];
  const lines = [
    '_Reported from a LubbDubb fault log. Every word below was checked against LubbDubb’s own source; anything else was removed before it left the machine._',
    '',
    `- **Where:** \`${group.source}\`${top ? ` at \`${top.file}:${top.line}\`` : ''}`,
    `- **Seen:** ${group.count} ${group.count === 1 ? 'time' : 'times'}, first ${days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} ago`}`,
    `- **Build:** \`${ctx.build}\` · ${ctx.runtime}`,
    `- **Fingerprint:** \`${fingerprint}\``,
    '',
    '### Message',
    '',
    '```',
    group.errorClass ? `${group.errorClass}: ${group.message}` : group.message || '(withheld)',
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
  const top = group.frames[0];
  const out: string[] = [];
  if (top) out.push(`- Read \`${top.file}\` around line ${top.line}, and the spec its header points to.`);
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

function newIssueUrl(base: string, title: string, body: string): string {
  const url = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return url.length > MAX_URL ? `${base}?title=${encodeURIComponent(title)}` : url;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
