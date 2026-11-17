import type { SlotBook } from './contract.js';

// → docs/spec/42-extensions.md#the-slots

const TENANT_SLOT_TIMEOUT_MS = 60 * 60 * 1000;

// A type alias, not an interface: `ExtensionHost` asks for a `SlotMap`, and only an alias meets its index signature.
export type ExtensionSlots = {
  ensureTenant: { input: { environment: string; tenant: string | null }; output: { tenant: string } };
  reseedTenant: { input: { environment: string; tenant: string }; output: undefined };
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
};
