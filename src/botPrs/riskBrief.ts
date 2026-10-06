import type { BotPr, BotPrDetail, BotPrFile, UpdateKind } from '../types.js';
import { isLockfile } from './lockfiles.js';

// → docs/spec/37-bot-prs.md#what-the-agent-is-given

const MAX_NOTES = 6_000;
const MAX_PATCHES = 8_000;

const NOT_A_SOURCE = new Set(['renovatebot', 'dependabot', 'apps', 'marketplace', 'settings']);

const KIND_ORDER: Record<UpdateKind, number> = { major: 0, minor: 1, patch: 2, unknown: 3 };

export function riskOrder(a: BotPr, b: BotPr): number {
  return KIND_ORDER[a.update.kind] - KIND_ORDER[b.update.kind] || a.number - b.number;
}

/** Renovate's "### Release Notes" section, or Dependabot's `<summary>Release notes</summary>` block. */
export function releaseNotesInBody(body: string | null): string | null {
  if (body === null) return null;
  const start = /(?:^|\n)(?:#{2,4}\s*release notes|<summary>\s*release notes)/i.exec(body);
  if (start === null) return null;
  const rest = body.slice(start.index);
  const end = /\n(?:---\s*\n+)?#{2,4}\s*configuration|\n<details>\s*\n?\s*<summary>\s*commits/i.exec(rest);
  const notes = (end === null ? rest : rest.slice(0, end.index)).trim();
  return notes === '' ? null : notes;
}

/** The dependency's own repository, where the body links one: the first github.com repository that is no bot's. */
export function sourceRepoInBody(body: string | null): { owner: string; repo: string } | null {
  if (body === null) return null;
  for (const m of body.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
    const owner = m[1]!;
    const repo = m[2]!.replace(/\.git$/, '');
    if (!NOT_A_SOURCE.has(owner.toLowerCase())) return { owner, repo };
  }
  return null;
}

export function releaseTags(packageName: string | null, to: string | null): string[] {
  if (to === null) return [];
  const bare = to.replace(/^v/, '');
  const tags = [`v${bare}`, bare];
  if (packageName !== null) tags.push(`${packageName}@${bare}`);
  return tags;
}

export interface BriefEntry {
  pr: BotPr;
  detail: BotPrDetail;
  notes: { text: string; from: 'pull request' | 'release' } | null;
}

export function riskBriefing(entries: readonly BriefEntry[]): string {
  const sections = entries.map(entrySection);
  return `\n\n## The pull requests (${String(entries.length)})\n\n${sections.join('\n\n')}`;
}

function entrySection({ pr, detail, notes }: BriefEntry): string {
  const { update } = pr;
  const lines = [
    `### PR ${String(pr.number)}: ${pr.title}`,
    '',
    `- Package: ${update.packageName ?? '(not named)'}`,
    `- Change: ${update.from ?? '?'} → ${update.to ?? '?'} (${update.kind})`,
    `- CI on the head: ${pr.ciStatus}`,
    '',
    '#### Release notes',
    '',
    notes === null ? 'None found.' : `From the ${notes.from}:\n\n${capped(notes.text, MAX_NOTES)}`,
    '',
    '#### Changed files',
    '',
    filesSection(detail.files),
  ];
  return lines.join('\n');
}

function filesSection(files: BotPrFile[] | null): string {
  if (files === null) return 'The provider did not list the changed files.';
  if (files.length === 0) return 'No changed files were listed.';
  const out: string[] = [];
  let budget = MAX_PATCHES;
  for (const file of files) {
    const counts = file.additions === null ? '' : ` (+${String(file.additions)} −${String(file.deletions ?? 0)})`;
    if (isLockfile(file.path)) {
      out.push(`- ${file.path}${counts}: a lockfile, contents left out`);
      continue;
    }
    if (file.patch === null) {
      out.push(`- ${file.path}${counts}`);
      continue;
    }
    if (budget <= 0) {
      out.push(`- ${file.path}${counts}: diff left out, over the length this brief allows`);
      continue;
    }
    const patch = capped(file.patch, budget);
    budget -= patch.length;
    out.push(`- ${file.path}${counts}:\n\n\`\`\`diff\n${patch}\n\`\`\``);
  }
  return out.join('\n');
}

export function capped(text: string, max: number): string {
  if (text.length <= max) return text;
  const line = text.lastIndexOf('\n', max);
  return `${text.slice(0, line > 0 ? line : max)}\n… (cut at ${String(max)} characters)`;
}
