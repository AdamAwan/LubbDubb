// → docs/spec/35-ejection.md

export interface EjectionPolicy {
  enabled: boolean;
  expiryHours: number;
  contactGraceMinutes: number;
}

export const DEFAULT_EJECTION: EjectionPolicy = {
  enabled: true,
  expiryHours: 8,
  contactGraceMinutes: 15,
};

export function expiresAt(ejectedAt: string, policy: EjectionPolicy): string | null {
  if (policy.expiryHours <= 0) return null;
  return new Date(Date.parse(ejectedAt) + policy.expiryHours * 3_600_000).toISOString();
}

export function expired(ejectedAt: string, now: string, policy: EjectionPolicy): boolean {
  const at = expiresAt(ejectedAt, policy);
  return at !== null && Date.parse(now) >= Date.parse(at);
}
