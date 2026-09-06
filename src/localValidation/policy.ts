import type { ExtraMcpServer } from '../types.js';

// → docs/spec/32-local-validation.md

export interface LocalValidationPolicy {
  instruction: string;
  browser: ExtraMcpServer | null;
}

export const DEFAULT_LOCAL_VALIDATION: LocalValidationPolicy = {
  instruction: '',
  browser: {
    key: 'browser',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--output-dir', '{outputDir}', '--user-data-dir', '{profileDir}'],
  },
};

const TOKENS = ['outputDir', 'profileDir'] as const;

export function substituteBrowserArgs(
  server: ExtraMcpServer,
  paths: { outputDir: string; profileDir: string },
): ExtraMcpServer {
  return {
    ...server,
    args: server.args.map((arg) => TOKENS.reduce((acc, token) => acc.split(`{${token}}`).join(paths[token]), arg)),
  };
}
