import type { SlotBook } from './contract.js';
import { ERRORS_COMMAND_TIMEOUT_MS } from '../appErrors/command.js';
import { READING_TIMEOUT_MS } from '../environments/prober.js';
import type { WatchSourceLanguage } from '../types.js';
import type { WatchQueryKind, WatchRow } from '../environments/watchResult.js';

// → docs/spec/42-extensions.md#the-slots

const TENANT_SLOT_TIMEOUT_MS = 60 * 60 * 1000;
const ROUTE_REVIEW_TIMEOUT_MS = 2 * 60 * 1000;
const PUBLISH_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

interface ReviewedPr {
  number: number;
  title: string;
  branch: string;
  base: string;
  author: string | null;
  body: string | null;
}

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
      language: WatchSourceLanguage;
      checkId: string;
      query: string;
      kind: WatchQueryKind;
      since: string;
      until: string;
      commits: string[] | null;
    };
    output: WatchRow[];
  };
  watchExposure: { input: { environment: string; commits: string[] }; output: { share: number } };
  routeReview: {
    input: { pr: ReviewedPr; modes: string[]; allowSkip: boolean };
    output: { mode: string; reason: string } | { skip: true; reason: string };
  };
  publishReview: {
    input: {
      pr: number;
      headSha: string | null;
      mode: string | null;
      verdict: 'clear' | 'findings';
      summary: string;
      findings: string[];
    };
    output: { thread: string | null };
  };
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
  deployedCommits: { timeoutMs: READING_TIMEOUT_MS, check: deployedCommitsRefusal },
  appErrors: {
    timeoutMs: ERRORS_COMMAND_TIMEOUT_MS,
    check: (value) =>
      typeof value === 'object' && value !== null
        ? null
        : 'it must answer the error groups as a list, or { groups, query?, queryLink? }',
  },
  appErrorDetail: {
    timeoutMs: ERRORS_COMMAND_TIMEOUT_MS,
    check: (value) => {
      const text = (value as { text?: unknown } | null)?.text;
      return typeof text === 'string' && text.trim() !== ''
        ? null
        : 'it must answer { text: "<what the telemetry holds on this group>" } — nothing to say is a throw';
    },
  },
  watchReading: {
    timeoutMs: READING_TIMEOUT_MS,
    check: (value) =>
      Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))
        ? null
        : 'it must answer a list of rows, each an object',
  },
  watchExposure: {
    timeoutMs: READING_TIMEOUT_MS,
    check: (value) => {
      const share = (value as { share?: unknown } | null)?.share;
      return typeof share === 'number' && Number.isFinite(share) && share >= 0 && share <= 1
        ? null
        : 'it must answer { share }, a number from 0 to 1';
    },
  },
  routeReview: {
    timeoutMs: ROUTE_REVIEW_TIMEOUT_MS,
    check: (value) => {
      if (typeof value !== 'object' || value === null)
        return 'it must answer { mode: "<name>", reason } or { skip: true, reason }';
      const { mode, skip, reason } = value as { mode?: unknown; skip?: unknown; reason?: unknown };
      if (typeof reason !== 'string' || reason.trim() === '') return '"reason" must say why, in words';
      if (skip === true) return mode === undefined ? null : 'give "mode" or "skip: true", not both';
      if (skip !== undefined) return '"skip" must be true, or be left out';
      return typeof mode === 'string' && mode.trim() !== '' ? null : '"mode" must name one of the modes it was given';
    },
  },
  publishReview: {
    timeoutMs: PUBLISH_REVIEW_TIMEOUT_MS,
    check: (value) => {
      if (typeof value !== 'object' || value === null) return 'it must answer { thread: "<id>" } or { thread: null }';
      const { thread } = value as { thread?: unknown };
      if (thread === null) return null;
      return typeof thread === 'string' && thread.trim() !== '' && !/[\r\n]/.test(thread)
        ? null
        : '"thread" must be the one-line id of the thread it published into, or null';
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
