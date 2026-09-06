import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { FilingTarget } from '../sink/actionSink.js';

// → docs/spec/13-jobs-and-tickets.md

const execFileAsync = promisify(execFile);

export const UPSTREAM_REPO = 'AdamAwan/LubbDubb';

export interface UpstreamIssues {
  describeTarget(): Promise<FilingTarget>;
  create(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
}

export function fleetWorksUpstream(config: Config): boolean {
  const gh = config.github;
  if (config.integrations.issues !== 'github' || !gh) return false;
  return `${gh.owner}/${gh.repo}`.toLowerCase() === UPSTREAM_REPO.toLowerCase();
}

function ghFailure(err: unknown): Error {
  const e = err as { stderr?: string; message?: string; code?: string };
  const detail = (e.stderr ?? '').trim() || e.message || String(err);
  if (e.code === 'ENOENT')
    return new Error(
      `the GitHub CLI (gh) is not installed on this machine, so nothing here can file into ${UPSTREAM_REPO}`,
    );
  return new Error(detail);
}

export function ghCliUpstreamIssues(): UpstreamIssues {
  return {
    async describeTarget(): Promise<FilingTarget> {
      try {
        const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
        const login = stdout.trim();
        return { target: UPSTREAM_REPO, identity: login === '' ? null : login };
      } catch (err) {
        throw ghFailure(err);
      }
    },
    async create(input): Promise<{ number: number; url: string }> {
      const args = ['issue', 'create', '--repo', UPSTREAM_REPO, '--title', input.title, '--body', input.body];
      for (const label of input.labels) args.push('--label', label);
      let url: string;
      try {
        const { stdout } = await execFileAsync('gh', args);
        url = stdout.trim().split(/\s+/).at(-1) ?? '';
      } catch (err) {
        throw ghFailure(err);
      }
      const number = Number(url.split('/').at(-1));
      if (!Number.isInteger(number)) throw new Error(`the GitHub CLI created something but did not say what: "${url}"`);
      return { number, url };
    },
  };
}
