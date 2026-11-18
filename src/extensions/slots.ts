import type { SlotBook } from './contract.js';

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
