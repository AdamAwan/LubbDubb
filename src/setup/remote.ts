// → docs/spec/26-setup.md

export interface RemoteTarget {
  provider: 'github' | 'azure';
  parts: readonly string[];
  url: string;
}

export function parseRemote(url: string): RemoteTarget | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const { host, path } = split(trimmed);
  if (host === null) return null;
  const segments = path
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);

  if (host === 'github.com' || host.endsWith('.github.com')) {
    if (segments.length < 2) return null;
    return { provider: 'github', parts: segments.slice(-2), url: trimmed };
  }

  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) {
    const gitAt = segments.indexOf('_git');
    const cleaned = segments[0] === 'v3' ? segments.slice(1) : segments;
    if (gitAt !== -1) {
      const before = segments.slice(0, gitAt);
      const repository = segments[gitAt + 1];
      if (repository === undefined) return null;
      const organization = before[0] ?? host.split('.')[0]!;
      const project = before.length > 1 ? before[before.length - 1]! : repository;
      return { provider: 'azure', parts: [organization, project, repository], url: trimmed };
    }
    if (cleaned.length >= 3) return { provider: 'azure', parts: cleaned.slice(-3), url: trimmed };
    return null;
  }

  return null;
}

function split(url: string): { host: string | null; path: string } {
  const scp = /^(?:([^@/]+)@)?([^/:]+):(.+)$/.exec(url);
  if (scp && !url.includes('://')) return { host: scp[2]!.toLowerCase(), path: scp[3]! };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:') {
      return { host: null, path: '' };
    }
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
  } catch {
    return { host: null, path: '' };
  }
}

export function credentialVar(provider: string): string | null {
  if (provider === 'github') return 'GITHUB_TOKEN';
  if (provider === 'azure') return 'AZURE_DEVOPS_PAT';
  return null;
}
