import type { Config } from '../config/config.js';

// → docs/spec/16-http-api.md

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** Where this harness serves its API and the cockpit, as a URL on this machine. */
export function apiUrl(config: Pick<Config, 'host' | 'port'>): string {
  const host = LOOPBACK_HOSTS.has(config.host) ? config.host : '127.0.0.1';
  return `http://${host}:${config.port}`;
}
