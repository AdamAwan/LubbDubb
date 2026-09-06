import type { EnvironmentHealthState, EnvironmentHealthTier } from '../types.js';

// → docs/spec/24-environments.md

const MAX_REASONS = 12;

const MAX_REASON_CHARS = 200;

const TIERS: readonly EnvironmentHealthTier[] = ['red', 'orange'];

export interface EnvironmentHealthReport {
  state: EnvironmentHealthState;
  tier: EnvironmentHealthTier | null;
  reasons: string[];
  detail: string | null;
}

export function unreadable(detail: string): EnvironmentHealthReport {
  return { state: 'unknown', tier: null, reasons: [], detail };
}

export function parseHealthReport(stdout: string): EnvironmentHealthReport {
  const text = stdout.trim();
  if (text === '') return unreadable('the health check printed nothing');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return unreadable(`the health check did not answer with JSON: ${(err as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return unreadable('the health check answered with something other than a {"state": …} report');
  const report = json as Record<string, unknown>;
  const state = readState(report['state']);
  if (state === null)
    return unreadable('the health check named no state the harness knows — "Healthy", "NotHealthy" or "Unknown"');
  const reasons = readReasons(report['reasons']);
  if (reasons === null) return unreadable('"reasons" must be a list of sentences saying what is wrong');
  const tier = readTier(report['tier']);
  if (tier === null) return unreadable(`"tier" must be ${TIERS.join(' or ')} — the harness ranks no others`);
  if (state !== 'unhealthy' && tier !== undefined)
    return unreadable(`a "${state}" report carries no tier — a tier says how bad an unhealthy one is`);
  return { state, tier: tier ?? null, reasons, detail: null };
}

function readState(value: unknown): EnvironmentHealthState | null {
  if (typeof value !== 'string') return null;
  const word = value.toLowerCase().replace(/[^a-z]/g, '');
  if (word === 'healthy' || word === 'ok') return 'healthy';
  if (word === 'nothealthy' || word === 'unhealthy') return 'unhealthy';
  if (word === 'unknown') return 'unknown';
  return null;
}

function readTier(value: unknown): EnvironmentHealthTier | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  return TIERS.find((t) => t === word) ?? null;
}

function readReasons(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim().slice(0, MAX_REASON_CHARS))
    .filter((r) => r !== '')
    .slice(0, MAX_REASONS);
}
