import type { SlotBook } from './contract.js';

// → docs/spec/42-extensions.md#the-slots

const TENANT_SLOT_TIMEOUT_MS = 60 * 60 * 1000;

const READING_SLOT_TIMEOUT_MS = 30_000;

const ERRORS_SLOT_TIMEOUT_MS = 60_000;

type WatchRowValue = string | number | boolean | null;

// A type alias, not an interface: `ExtensionHost` asks for a `SlotMap`, and only an alias meets its index signature.
export type ExtensionSlots = {
  ensureTenant: { input: { environment: string; tenant: string | null }; output: { tenant: string } };
  reseedTenant: { input: { environment: string; tenant: string }; output: undefined };
  deployedCommits: { input: { environment: string }; output: { commits: string[] } };
  appErrors: { input: { environment: string; since: string }; output: unknown };
  appErrorDetail: {
    input: { environment: string; fingerprint: string; since: string };
    output: { text: string };
  };
  watchReading: {
    input: {
      environment: string;
      source: string;
      language: 'kql' | 'sql' | 'promql' | 'other';
      checkId: string;
      query: string;
      kind: 'signal' | 'presence' | 'measure';
      since: string;
      until: string;
      commits: string[] | null;
    };
    output: Record<string, WatchRowValue>[];
  };
  watchExposure: { input: { environment: string; commits: string[] }; output: { share: number } };
};

export const EXTENSION_SLOTS: SlotBook<ExtensionSlots> = {
  ensureTenant: {
    timeoutMs: TENANT_SLOT_TIMEOUT_MS,
    check: (value) => {
      if (typeof value !== 'object' || value === null) return 'it must answer { tenant: "<name>" }';
      const { tenant } = value as { tenant?: unknown };
      if (typeof tenant !== 'string' || tenant.trim() === '' || /[\r\n]/.test(tenant))
        return '"tenant" must be the one-line name of the tenant it provisioned — the harness never invents one';
      return null;
    },
  },
  reseedTenant: {
    timeoutMs: TENANT_SLOT_TIMEOUT_MS,
    check: (value) => (value === undefined ? null : 'it must answer nothing — a throw is how it says it failed'),
  },
  deployedCommits: { timeoutMs: READING_SLOT_TIMEOUT_MS, check: deployedCommitsRefusal },
  appErrors: {
    timeoutMs: ERRORS_SLOT_TIMEOUT_MS,
    check: (value) =>
      typeof value === 'object' && value !== null
        ? null
        : 'it must answer the error groups as a list, or { groups, query?, queryLink? }',
  },
  appErrorDetail: {
    timeoutMs: ERRORS_SLOT_TIMEOUT_MS,
    check: (value) => {
      const text = (value as { text?: unknown } | null)?.text;
      return typeof text === 'string' && text.trim() !== ''
        ? null
        : 'it must answer { text: "<what the telemetry holds on this group>" } — nothing to say is a throw';
    },
  },
  watchReading: {
    timeoutMs: READING_SLOT_TIMEOUT_MS,
    check: (value) =>
      Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))
        ? null
        : 'it must answer a list of rows, each an object',
  },
  watchExposure: {
    timeoutMs: READING_SLOT_TIMEOUT_MS,
    check: (value) => {
      const share = (value as { share?: unknown } | null)?.share;
      return typeof share === 'number' && Number.isFinite(share) && share >= 0 && share <= 1
        ? null
        : 'it must answer { share }, a number from 0 to 1';
    },
  },
};

function deployedCommitsRefusal(value: unknown): string | null {
  const commits = (value as { commits?: unknown } | null)?.commits;
  if (!Array.isArray(commits) || commits.length === 0)
    return 'it must answer { commits: ["<sha>", …] } naming at least one commit — not knowing is a throw';
  if (!commits.every((c) => typeof c === 'string' && c.trim() !== '' && !/\s/.test(c)))
    return 'each entry of "commits" must be one commit, a non-blank token with no spaces';
  return null;
}
