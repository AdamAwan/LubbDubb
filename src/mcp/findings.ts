import type { Config } from '../config/config.js';

// → docs/spec/11-mcp-tools.md

export function parseItemRef(ref: unknown): { ok: true; ref: string | null } | { ok: false; error: string } {
  if (ref === undefined || ref === null) return { ok: true, ref: null };
  if (typeof ref !== 'string') return { ok: false, error: 'ref must be a string like "issue:41", or omitted.' };
  const raw = ref.trim();
  if (!raw) return { ok: true, ref: null };

  const m = /^(pr|issue):(.+)$/.exec(raw);
  if (!m) {
    return {
      ok: false,
      error:
        `ref "${raw}" is not a harness ref. Use "pr:42" or "issue:41" — a bare number is ` +
        'ambiguous between an issue and a PR. If the finding is about something the harness does not ' +
        'track (an upstream package, say), omit ref and describe it in the summary.',
    };
  }
  const kind = m[1] as 'pr' | 'issue';
  const rest = m[2] ?? '';
  const head = rest.split(':')[0]?.replace(/^#/, '') ?? '';
  if (!/^\d+$/.test(head)) return { ok: false, error: `ref "${raw}" does not contain a ${kind} number.` };
  return { ok: true, ref: `${kind}:${Number(head)}` };
}

export function trackerCoordinates(config: Config): string | null {
  const provider = config.integrations.issues;
  if (provider === 'github' && config.github) {
    return `the GitHub repository ${config.github.owner}/${config.github.repo}`;
  }
  if (provider === 'azure' && config.azureDevOps) {
    const { organization, project } = config.azureDevOps;
    return `the Azure DevOps project "${project}" in organization "${organization}"`;
  }
  return null;
}
